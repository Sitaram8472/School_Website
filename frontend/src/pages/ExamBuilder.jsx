import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../utils/axios';

const ExamBuilder = () => {
  const navigate = useNavigate();
  const { courseId } = useParams();
  
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [timeLimit, setTimeLimit] = useState(30);
  const [questions, setQuestions] = useState([]);

  const handleAddQuestion = (type) => {
    setQuestions([
      ...questions, 
      { type, questionText: '', options: ['', '', '', ''], correctAnswer: '', points: 1 }
    ]);
  };

  const handleQuestionChange = (index, field, value) => {
    const newQuestions = [...questions];
    newQuestions[index][field] = value;
    setQuestions(newQuestions);
  };

  const handleOptionChange = (qIndex, oIndex, value) => {
    const newQuestions = [...questions];
    newQuestions[qIndex].options[oIndex] = value;
    setQuestions(newQuestions);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const response = await api.post('/exams', {
        title,
        description,
        course: courseId, // Using the param from route
        timeLimit,
        isPublished: true,
        questions
      });

      if (response.data.success) {
        alert('Exam Created Successfully!');
        navigate('/teacher/dashboard');
      } else {
        alert('Failed to create exam: ' + response.data.message);
      }
    } catch (err) {
      console.error(err);
      alert('An error occurred: ' + (err.response?.data?.message || err.response?.data?.error || err.message));
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow-md my-8">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Create New Exam</h2>
      <form onSubmit={handleSubmit}>
        <div className="mb-4">
          <label className="block text-gray-700 font-medium mb-2">Exam Title</label>
          <input 
            type="text" 
            value={title} 
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />
        </div>
        
        <div className="mb-4">
          <label className="block text-gray-700 font-medium mb-2">Description</label>
          <textarea 
            value={description} 
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            rows="3"
          />
        </div>

        <div className="mb-6">
          <label className="block text-gray-700 font-medium mb-2">Time Limit (Minutes)</label>
          <input 
            type="number" 
            value={timeLimit} 
            onChange={(e) => setTimeLimit(e.target.value)}
            className="w-32 px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            min="1"
            required
          />
        </div>

        <div className="mb-6">
          <h3 className="text-xl font-semibold mb-4">Questions</h3>
          {questions.map((q, qIndex) => (
            <div key={qIndex} className="p-4 border rounded-md mb-4 bg-gray-50">
              <div className="flex justify-between items-center mb-2">
                <span className="font-medium">Question {qIndex + 1} ({q.type})</span>
                <button type="button" onClick={() => setQuestions(questions.filter((_, i) => i !== qIndex))} className="text-red-500 hover:text-red-700">Remove</button>
              </div>
              <input 
                type="text" 
                placeholder="Enter question text..." 
                value={q.questionText}
                onChange={(e) => handleQuestionChange(qIndex, 'questionText', e.target.value)}
                className="w-full px-4 py-2 border rounded-md mb-2 focus:outline-none"
                required
              />
              
              {q.type === 'MCQ' && (
                <div className="ml-4">
                  {q.options.map((opt, oIndex) => (
                    <div key={oIndex} className="flex items-center mb-2">
                      <input 
                        type="radio" 
                        name={`correct-${qIndex}`} 
                        checked={q.correctAnswer === opt && opt !== ''}
                        onChange={() => handleQuestionChange(qIndex, 'correctAnswer', opt)}
                        className="mr-2"
                        required
                      />
                      <input 
                        type="text" 
                        placeholder={`Option ${oIndex + 1}`} 
                        value={opt}
                        onChange={(e) => handleOptionChange(qIndex, oIndex, e.target.value)}
                        className="flex-grow px-2 py-1 border rounded-md focus:outline-none"
                        required
                      />
                    </div>
                  ))}
                </div>
              )}

              {q.type === 'ShortAnswer' && (
                <input 
                  type="text" 
                  placeholder="Expected answer (optional keywords)" 
                  value={q.correctAnswer}
                  onChange={(e) => handleQuestionChange(qIndex, 'correctAnswer', e.target.value)}
                  className="w-full px-4 py-2 border rounded-md mt-2 focus:outline-none"
                />
              )}
            </div>
          ))}

          <div className="flex space-x-4">
            <button type="button" onClick={() => handleAddQuestion('MCQ')} className="px-4 py-2 bg-blue-100 text-blue-700 rounded-md hover:bg-blue-200">
              + Add MCQ
            </button>
            <button type="button" onClick={() => handleAddQuestion('ShortAnswer')} className="px-4 py-2 bg-green-100 text-green-700 rounded-md hover:bg-green-200">
              + Add Short Answer
            </button>
          </div>
        </div>

        <button type="submit" className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium text-lg">
          Publish Exam
        </button>
      </form>
    </div>
  );
};

export default ExamBuilder;
